# Plan Briefing

Use this briefing only after the complete harness is `QA READY`. Turn the request into a focused, run-local validation
plan without redesigning or shrinking the harness.

## Input

Use the original request, exact target, completed `run-context.md`, repository/Context Tree context, existing tests, and
the case library. Ask a human only when a product or scope decision cannot be resolved from those inputs or a safe
conservative default.

## Steps

- State one validation question.
- Select product and cross-surface paths that answer it, including credible adjacent risk.
- Select relevant cases from `cases/` and add task-specific exploratory checks when needed.
- Choose data, identities, roles, failure/recovery branches, and reset points from the ready harness.
- Choose real-product evidence and any deeper performance protocol required by the task or risk.
- Record out-of-scope areas, resource limits, and stop conditions.

For an unscoped request such as "QA this repository," plan full-system QA: all repository-supported suites, every formal
surface, critical cross-surface journeys, installation/recovery, persistence/restart, performance characterization, and
risk-based exploration.

## Plan Shape

Keep the plan concise:

- target, request, and validation question;
- reference to the ready run context;
- in-scope surfaces, journeys, tests, cases, and task-specific checks;
- data and identity setup for the selected scenarios;
- evidence and performance work needed for the conclusion;
- out-of-scope behavior, limits, and `BLOCKED`/`INCONCLUSIVE` stop conditions.

If data creation is itself under test, create it through the product. Direct fixture or database setup is acceptable only
as a recorded precondition and is not product-behavior evidence.
