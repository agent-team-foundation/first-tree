# QA Cases

QA cases are reusable prompts for capable agents. They help agents remember high-risk behavior slices and useful
observations, but they are not executable specs.

## Area Vocabulary

Use these areas for discovery, not as a hard taxonomy:

- `cli/`
- `runtime/`
- `server/`
- `web/`
- `cross-surface/`

Areas do not define ownership, product domains, or Context Tree taxonomy. If a case is cross-surface, put it where the
primary validation question lives and name the other surfaces in the body.

## Case Shape

Use minimal frontmatter for lookup and reference:

```md
---
id: stable-case-id
description: Short non-structured summary.
areas: [runtime]
surfaces: [cli, client]
---
```

Write the body as prose. A useful case usually explains:

- the validation goal;
- required and forbidden preconditions;
- the checklist or branches an agent should consider;
- evidence that would make the result credible;
- expected behavior and notable limitations.

Do not encode case flow as a rigid DSL. Normal and abnormal branches can live in prose when they answer the same
validation question.

## Granularity

- One case should answer one primary validation question.
- A QA task can combine multiple cases.
- Parameter matrices belong in the QA plan unless a variant is high-risk and independently reusable.
- Checks that can be stable automated product tests should move to the product test suite instead of living here.

## Review Check

A good case gives the executing agent better judgment. It should not force the case author to predict months in advance
which exact screen, table, log line, or provider state will be available in a future run. Put those live choices in the
run-local plan.

## Run Feedback And Maintenance

Every formal run records one case disposition in its final report:

- `no-change` when selected cases remained useful and no durable gap emerged;
- `candidate-new-case` or `candidate-case-update` for reusable live or judgment-dependent risk;
- `move-to-product-test` for stable deterministic behavior;
- `move-to-skill-eval` for recurring agent behavior;
- `merge-or-retire` for redundant, obsolete, or fully automated cases.

Record the relevant case ID, target ref, evidence, affected surfaces, and why the disposition fits. Candidate prose may
live in the temporary run artifacts, but formal QA never edits the committed library.

Add, update, merge, or retire committed cases only in a separate maintenance task. Preserve the ID while the primary
validation question remains stable; create a new ID when that identity changes. Rewrite cases to current truth rather
than appending run history.
