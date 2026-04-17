# `first-tree skill` (meta)

Diagnostic / maintenance commands for the four skill payloads that ship with this package (`first-tree`, `tree`, `breeze`, `gardener`). **This is not a product** — it's a meta command, excluded from `PRODUCTS` in [`src/products/manifest.ts`](../../products/manifest.ts) and rendered under the "Diagnostics" section of `first-tree --help`.

## What's in this directory

```
skill-tools/
├── VERSION
├── cli.ts                 # dispatcher
└── engine/
    ├── commands/          # list.ts, doctor.ts, link.ts
    └── lib/paths.ts       # shared skill layout helpers
```

## Commands

| Command | Role |
|---------|------|
| `first-tree skill list` | Print the four bundled skills with installed status + version |
| `first-tree skill doctor` | Diagnose skill-install health (exits non-zero on problems) |
| `first-tree skill link` | Idempotently repair `.claude/skills/*` alias symlinks |

The `list/doctor/link` trio is the canonical entrypoint an agent reaches for when the `first-tree` umbrella skill's **"Managing Skills On This Machine"** section sends them here.

## Related

- Tests: [`tests/meta/skill-commands.test.ts`](../../../tests/meta/skill-commands.test.ts)
