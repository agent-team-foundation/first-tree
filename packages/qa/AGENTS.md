# QA Package Instructions

`@first-tree/qa` is the internal entry point for agent-run QA work in this repository. It owns reusable QA
briefings, natural-language QA cases, isolated environment recipes, observability guidance, and reusable fixtures.

It is not a test runner, a CLI, a CI gate, or a replacement for product unit, integration, or E2E tests.

## Required Invariants

A formal QA result cannot be `PASS` when any of these invariants is violated:

1. Formal QA runs in Docker plus a temporary git worktree, not in the operator's original checkout.
2. The QA role does not modify the tested product object. Test data, config, and fixtures may change only inside the
   isolated run cell as part of validation.
3. `PASS` requires real product behavior evidence. Insufficient evidence is `BLOCKED` or `INCONCLUSIVE`.
4. Run artifacts are written to a temporary run directory, not committed to the source repository.
5. Environment, dependency, credential, provider/auth, or data-precondition failures are `BLOCKED`, not product `FAIL`.

## Working Model

- Start from a QA task request, not from a complete test plan.
- Read the relevant repository, issue, PR, design, or Context Tree context before planning.
- Create a run-local QA plan before executing validation.
- Use cases as reusable prompts for a capable agent, not as a rigid machine DSL.
- Choose observability evidence based on the task, case scope, and live risk.
- Report limitations plainly when coverage is partial.

## Result Statuses

- `PASS`: planned scope was validated with enough real product evidence and no product issue was found.
- `FAIL`: a reproducible product issue was found and a bug artifact should be produced.
- `BLOCKED`: setup, dependency, data, permission, provider/auth, or environment preconditions prevented validation.
- `INCONCLUSIVE`: some validation ran, but evidence was insufficient, unstable, interrupted, or incomplete.

## Package Boundaries

- Put case authoring guidance under `cases/`.
- Put execution guidance under `briefings/`.
- Put environment recipes under `environment/`.
- Put observability capability guidance under `observability/`.
- Put reusable, non-run-specific assets under `fixtures/`.
- Do not add a public `bin`, lifecycle CLI, automated runner, or guard command without a separate design decision.
