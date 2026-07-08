# Plan Briefing

Use this briefing to turn a QA task request into a run-local QA plan.

## Input

A task request should identify the target, objective, scope, context, risk focus, environment constraints, and reporting
expectations. It does not need to be a complete test plan.

If a human provides a test plan, treat it as input context. The run-local QA plan is still the artifact of record for the
current run.

Ask a human only when the next step depends on a product or scope decision that cannot be settled from the request,
repository, Context Tree, or a conservative default. Missing setup facts can usually be recorded as assumptions or stop
conditions instead.

## Steps

- Read the required task context before selecting cases.
- Identify the product surfaces and behavior boundaries that must be validated.
- Select relevant cases from `cases/` and add task-specific exploratory checks when needed.
- Decide the run cell shape and which services are actually required.
- Decide data setup, provider/auth readiness, and external-access needs.
- Decide which observability capabilities are necessary to support the conclusion.
- Record known limitations and out-of-scope areas before executing.

## Plan Shape

Keep the plan short enough to guide execution:

- target object and ref;
- validation question;
- product surfaces in scope;
- selected reusable cases and task-specific checks;
- run-cell shape and required services;
- data setup and provider/auth readiness;
- evidence needed for a credible conclusion;
- out-of-scope areas and known limits;
- stop conditions that produce `BLOCKED` or `INCONCLUSIVE`.

## Data Boundary

Environment setup creates a known baseline. Case-specific data preparation creates the state needed to answer the
validation question. If data creation is itself the tested behavior, create that data through the product entry point.
If data is only a precondition, direct fixture or database setup is acceptable inside the isolated QA database when it is
recorded as setup rather than product evidence.
