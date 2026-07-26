# @first-tree/qa

First Tree-specific QA assets consumed by the shipped `first-tree-qa` skill.

The skill owns the universal lifecycle: discover the complete product, establish a complete harness, gate `QA READY`,
scope the task, execute real behavior, and report evidence plus case disposition. This package adds the stricter First
Tree run-cell contract and the cases, recipes, templates, and fixtures needed to apply that lifecycle to this repository.
It does not define a second workflow.

Deterministic behavior belongs in product tests. Recurring agent behavior belongs in `@first-tree/skill-evals`. This
package is for live, cross-surface, provider-backed, release, exploratory, or judgment-dependent validation.

## Run Artifacts

Keep all process output under a temporary run directory, never in the repository:

- `run-context.md` records target identity, the product-surface capability matrix, harness state, performance baselines,
  and the `QA READY` outcome.
- `plan.md` is created only after readiness and records the task validation question, selected cases, scope, evidence,
  limits, and stop conditions.
- `evidence/` holds logs, screenshots, command output, API probes, database notes, performance observations, or runtime
  traces.
- `report.md` states one status and includes scope, evidence, performance, limitations, artifact paths, and case
  disposition.

Start from `templates/` when useful and keep artifacts proportional to the run.

## Directory Map

- `AGENTS.md` contains the First Tree-specific formal QA contract.
- `briefings/` covers harness setup, post-readiness planning, execution, and reporting.
- `cases/` stores reusable prose QA cases and authoring guidance.
- `environment/` provides isolated run-cell and bridge recipes.
- `observability/` covers evidence, readiness measurements, and redaction.
- `templates/` contains minimal run artifact templates.
- `fixtures/` stores reusable, non-sensitive assets, never run output.

The package deliberately has no public runner, lifecycle CLI, case validator, or CI gate.
