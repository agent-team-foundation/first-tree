# Execute Briefing

Use this briefing to execute a planned QA run and report the result.

## Execution Loop

- Execute against the isolated run cell described in the QA plan.
- Prefer black-box product entry points: CLI, HTTP API, web UI, daemon/runtime behavior, provider behavior, and persisted
  state.
- Use source reading to understand risk and interpret behavior, not as the only evidence for `PASS`.
- Adjust the plan when live facts contradict assumptions, and record the reason.
- Leave a traceable record of what ran, why it changed from the plan, and where the supporting evidence lives.
- Stop early with `BLOCKED` when required setup, data, credentials, or provider readiness cannot be established.
- Stop with `INCONCLUSIVE` when validation ran but evidence is incomplete, unstable, interrupted, or contradictory.

## Evidence

Choose the evidence needed for the task. Useful evidence can include command output, service logs, API responses, database
observations, screenshots, browser console output, provider smoke checks, or runtime turns. No single evidence type is
required for every run.

The report should connect each important conclusion to the evidence that supports it. If the evidence is too sensitive
to quote, summarize it and keep the local artifact path available for the operator.

## Reporting

Use one overall status: `PASS`, `FAIL`, `BLOCKED`, or `INCONCLUSIVE`.

A useful report includes:

- status and one-sentence conclusion;
- scope actually covered;
- evidence that supports the conclusion;
- findings, including any reproducible product bugs;
- limitations and skipped areas;
- artifact paths.

For `FAIL`, produce a bug artifact with reproduction steps, expected behavior, actual behavior, evidence, impact, and
suspected owner or dispatch direction. Do not turn the bug artifact into an implementation plan.
