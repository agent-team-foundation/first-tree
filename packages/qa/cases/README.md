# QA Cases

QA cases are reusable prompts for capable agents. They help agents remember high-risk behavior slices and useful
observations, but they are not executable specs.

## Organization

Cases are grouped by QA area:

- `cli/`
- `runtime/`
- `server/`
- `web/`
- `cross-surface/`

These directories are for discovery. They do not define ownership, product domains, or Context Tree taxonomy.

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

Do not encode case flow as a rigid DSL. Normal and abnormal branches can live in the prose checklist when they answer the
same validation question.

## Granularity

- One case should answer one primary validation question.
- A QA task can combine multiple cases.
- Parameter matrices belong in the QA plan unless a variant is high-risk and independently reusable.
- Checks that can be stable automated product tests should move to the product test suite instead of living here.
