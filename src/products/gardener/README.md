# `first-tree gardener`

Local maintenance agent for Context Trees. Keeps the tree coherent as code and
reviews evolve:

- **`respond`** — fixes sync PRs based on reviewer feedback (reactive maintenance).
- **`comment`** — reviews source-repo PRs / issues against the bound tree and posts structured verdict comments.

The intended scope extends beyond reactive maintenance: gardener should
proactively watch source repos for changes that affect tree coverage, open
corresponding issues on the tree repo, and assign the right owners. That
proactive layer is the next milestone and currently ships only the `respond` +
`comment` primitives.

## What's In This Directory

```text
gardener/
├── VERSION
├── README.md              # product overview
├── cli.ts                 # dispatcher
└── engine/
    ├── commands/          # respond.ts, comment.ts
    └── (domain modules)   # comment builder, classifier, gh helpers, …
```

## Commands

| Command | Role |
|---------|------|
| `first-tree gardener respond --pr <n> --repo owner/name` | Fix a sync PR based on reviewer feedback |
| `first-tree gardener comment --pr <n> --repo owner/name` | Review a source PR against the tree and post a verdict |
| `first-tree gardener comment --issue <n> --repo owner/name` | Same, for an issue |

Run `first-tree gardener --help` for the authoritative list.

## Related

- User-facing skill: [`skills/gardener/SKILL.md`](../../../skills/gardener/SKILL.md)
- Tests: [`tests/gardener/`](../../../tests/gardener)
- Gardener has no shipped `assets/` — it's a pure runtime tool.
