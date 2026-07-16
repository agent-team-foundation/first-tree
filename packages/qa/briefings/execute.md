# Execute Briefing

Use this briefing after `QA READY` and a run-local plan exist.

## Execution Loop

- Confirm the relevant harness capabilities and reset paths remain ready.
- Exercise final artifacts through CLI, HTTP, Web, SDK/client, daemon/runtime, provider, installer, and persisted-state
  boundaries selected by the plan.
- Use source and internal logs for risk discovery and diagnosis, not as the only evidence for product behavior.
- Verify meaningful preconditions and use independent readback or restart boundaries when needed.
- Save evidence and record findings as they occur; do not reconstruct the run from memory at the end.
- Adapt when live facts contradict the plan, recording what changed and why.
- Continue safe planned work after a finding while the harness remains trustworthy.
- Use `BLOCKED` for unmet external/setup preconditions and `INCONCLUSIVE` for partial, unstable, interrupted, or
  contradictory evidence.

## Evidence And Reporting

Connect each material conclusion to evidence that supports it. Summarize sensitive evidence and retain only safe local
artifact paths.

Return one overall status: `PASS`, `FAIL`, `BLOCKED`, or `INCONCLUSIVE`. Include:

- exact scope and target;
- harness readiness and environment limits;
- evidence and reproducible findings;
- performance observations relevant to readiness and the task;
- skipped, blocked, unstable, or out-of-scope areas;
- artifact paths and cleanup state;
- final case disposition: `no-change`, `candidate-new-case`, `candidate-case-update`, `move-to-product-test`,
  `move-to-skill-eval`, or `merge-or-retire`.

For `FAIL`, produce a bug artifact with reproduction, expected/actual behavior, evidence, impact, and likely dispatch
surface, but no implementation plan. Record case feedback without editing the committed case library during the run.
