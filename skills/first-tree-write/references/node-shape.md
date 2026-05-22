# Tree Node Shape

When write needs to create or edit a tree node, follow these conventions.
The validator (`first-tree tree verify`) enforces the structural pieces;
the rest are conventions the rest of the team relies on.

## Required Frontmatter

```yaml
---
title: "Short noun phrase"
owners: [alice, bob]
---
```

- `title` — a noun phrase, not a sentence. Reuse the file name when you
  can.
- `owners` — list of GitHub handles or team names. Use `[*]` only when
  the node is intentionally open to anyone.

Without both fields, `tree verify` fails.

## Optional Frontmatter

```yaml
soft_links:
  - other-domain/leaf
  - another-domain
lastReviewed: 2026-05-03
decisionLocksCode: false
```

- `soft_links` — references to related domains or leaves. Each target
  must resolve (the validator checks). Use when the decision references
  another domain but lives here.
- `lastReviewed` — ISO date the node was last sanity-checked by an
  owner. Skip on first creation; let sync set this as part of an audit.
- `decisionLocksCode` — `true` means "tree wins; escalate any drift to a
  human." Set only with explicit user instruction. The validator treats
  unknown frontmatter keys as opaque, so this is parsed but not
  enforced today.

## Body

Sections in this order, omit any you do not need:

1. **Decision** — one paragraph. The durable claim.
2. **Rationale** — why this decision; why the alternatives lost.
3. **Constraints** — what this implies for future implementations.
4. **Cross-Domain** — explicit links to other domains if not already in
   `soft_links`.
5. **Source** — link back to the PR / doc / note that motivated this
   node.

Do not add headings the body does not need. A 6-line node is better than
a 60-line one if it captures the same decision.

## What Goes Where

| Tree object              | Use for                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| Domain `NODE.md`         | Domain-level decisions, ownership of the whole domain, `soft_links` to siblings |
| Leaf `*.md` in a domain  | Specific decisions, constraints, supersession notes                             |
| `members/<id>/NODE.md`   | One person's responsibilities and review scope                                  |
| `source-repos.md` (root) | The list of source repos that consume this tree                                 |

If you cannot figure out where a fact goes, ask the user. Do not invent
a new top-level domain just to have somewhere to put it.

## Example: Adding A Constraint

PR #1234 adds a rule that all public APIs must support JSON streaming.
The right place is the API domain's existing `NODE.md` (or a leaf).

```markdown
---
title: "Public API streaming"
owners: [api-team]
soft_links:
  - sdk
  - gateway
---

# Public API streaming

## Decision

All public APIs must support JSON streaming responses. Single-shot
responses remain available for backward compatibility but are deprecated
for new endpoints.

## Rationale

Long-running queries were timing out on the gateway and clients had no
way to express partial-result streaming. JSON streaming aligns with the
SDK's existing parser.

## Constraints

- New endpoints MUST advertise streaming via the OpenAPI extension.
- Single-shot endpoints predating this rule continue to work; new
  endpoints follow streaming-first defaults.

## Source

[apps#1234](https://github.com/<org>/<repo>/pull/1234)
```

Note what is **not** in the example: the framing library, the buffer
size, the deserializer class. Those are implementation details that
belong in the source repo, not the tree.
