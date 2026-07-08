# @first-tree/qa

Internal QA workflow assets for agent-run First Tree validation.

This package is intentionally a prompt-and-asset package. It gives an agent enough structure to run credible QA without
turning QA judgment into a brittle schema or a fake test runner.

## Use This Package When

- A teammate asks for task-scoped QA of a PR, issue, release candidate, or behavior slice.
- The validation needs live product observation, multiple surfaces, runtime/provider behavior, or exploratory judgment.
- The output should be an honest QA report with evidence and limitations.

Do not use it as recurring regression infrastructure. Deterministic checks belong in product tests; recurring
agent-behavior regression coverage belongs in `@first-tree/skill-evals`.

## Run Shape

A normal QA run has four local artifacts, all under a temporary run directory:

- `plan.md` records the validation question, selected cases, environment, evidence, limits, and stop conditions.
- `run-context.md` records the target ref, run root, service endpoints, data setup, provider readiness, and known setup
  facts.
- `evidence/` holds logs, screenshots, command output, API probes, database notes, or runtime traces that support the
  conclusion.
- `report.md` states one result: `PASS`, `FAIL`, `BLOCKED`, or `INCONCLUSIVE`.

These artifacts are process output. Summarize them back to the requester; do not commit them to this package.

## Directory Map

- `AGENTS.md` is the package-level instruction contract.
- `briefings/` describes how to plan, set up, execute, and report a run.
- `cases/` describes how to author prose QA cases and stores reusable cases.
- `environment/` describes isolated run-cell recipes.
- `observability/` describes evidence choices and redaction rules.
- `fixtures/` is for reusable, non-sensitive QA assets only.

The package deliberately has no public `bin`, runner lifecycle, case validator, or CI gate.
