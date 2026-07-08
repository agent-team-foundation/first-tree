# QA Package Instructions

`@first-tree/qa` is the internal entry point for human-requested, agent-run QA work in this repository. It owns reusable
briefings, natural-language QA cases, isolated environment recipes, evidence guidance, and reusable fixtures.

It is not a test runner, a CLI, a CI gate, or a replacement for product unit, integration, E2E, or skill-eval coverage.
If a check can be made deterministic and stable, move it to the product test suite. If the goal is recurring regression
coverage for agent-backed behavior, use `@first-tree/skill-evals`. Use this package for task-scoped QA where a capable
agent must plan, observe, adapt, and report honestly.

## Required Invariants

A formal QA result cannot be `PASS` when any of these invariants is violated:

1. Formal QA runs in Docker plus a temporary git worktree, not in the operator's original checkout.
2. The QA role does not modify the tested product object. Test data, config, and fixtures may change only inside the
   isolated run cell as part of validation.
3. `PASS` requires real product behavior evidence. Insufficient evidence is `BLOCKED` or `INCONCLUSIVE`.
4. Run artifacts are written to a temporary run directory, not committed to the source repository.
5. Environment, dependency, credential, provider/auth, or data-precondition failures are `BLOCKED`, not product `FAIL`.

## Default Flow

1. Start from the QA task request. It can be incomplete; it does not need to be a test plan.
2. Read the relevant repository, issue, PR, design, or Context Tree context before planning.
3. Write a run-local QA plan that names the validation question, selected cases, run cell, evidence, limits, and stop
   conditions.
4. Prepare the smallest isolated run cell that can answer the question.
5. Execute through black-box product entry points where possible, adapt when live facts contradict assumptions, and keep
   evidence tied to conclusions.
6. Report one status with limitations and artifact locations.

Cases are reusable prompts for a capable agent, not a rigid machine DSL. They can guide judgment, but the run-local plan
and live product evidence own the current run.

## Result Statuses

- `PASS`: planned scope was validated with enough real product evidence and no product issue was found.
- `FAIL`: a reproducible product issue was found and a bug artifact should be produced.
- `BLOCKED`: setup, dependency, data, permission, provider/auth, or environment preconditions prevented validation.
- `INCONCLUSIVE`: some validation ran, but evidence was insufficient, unstable, interrupted, or incomplete.

## Package Boundaries

- Put case authoring guidance under `cases/`.
- Put execution guidance under `briefings/`.
- Put run-cell and provider-bridge recipes under `environment/`.
- Put evidence and redaction guidance under `observability/`.
- Put reusable, non-run-specific assets under `fixtures/`.
- Do not add a public `bin`, lifecycle CLI, automated runner, or guard command without a separate design decision.
