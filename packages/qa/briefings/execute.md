# Execute Briefing

Use this briefing to execute a planned QA run and report the result.

## Execution Principles

- Execute against the isolated run cell described in the QA plan.
- Prefer black-box product entry points: CLI, HTTP API, web UI, daemon/runtime behavior, provider behavior, and persisted
  state.
- Use source reading to understand risk and interpret behavior, not as the only evidence for `PASS`.
- Adjust the plan when live facts contradict assumptions, and record the reason.
- Stop early with `BLOCKED` when required setup, data, credentials, or provider readiness cannot be established.

## Evidence

Choose the evidence needed for the task. Useful evidence can include command output, service logs, API responses, database
observations, screenshots, browser console output, provider smoke checks, or runtime turns. No single evidence type is
required for every run.

The report should connect each important conclusion to the evidence that supports it. If the evidence is too sensitive
to quote, summarize it and keep the local artifact path available for the operator.

## Reporting

Use one overall status: `PASS`, `FAIL`, `BLOCKED`, or `INCONCLUSIVE`.

For `FAIL`, produce a bug artifact with reproduction steps, expected behavior, actual behavior, evidence, impact, and a
suspected cause or dispatch direction. Do not turn the bug artifact into an implementation plan.
