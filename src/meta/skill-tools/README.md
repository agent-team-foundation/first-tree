# `first-tree skill` (meta)

Diagnostic / maintenance commands for the four skill payloads that ship with
this package (`first-tree`, `tree`, `breeze`, `gardener`). **This is not a
product** — it is a meta command, excluded from `PRODUCTS` in
[`src/products/manifest.ts`](../../products/manifest.ts) and rendered under the
"Maintenance" section of `first-tree --help`.

## What's In This Directory

```text
skill-tools/
├── VERSION
├── README.md              # meta-command overview
├── cli.ts                 # dispatcher
└── engine/
    ├── commands/          # install.ts, upgrade.ts, list.ts, doctor.ts, link.ts
    └── lib/paths.ts       # shared skill layout helpers
```

## Commands

| Command | Role |
|---------|------|
| `first-tree skill install` | Install the four bundled skills into `.agents/skills/*` and `.claude/skills/*` |
| `first-tree skill upgrade` | Wipe and reinstall the four bundled skills from the current package |
| `first-tree skill list` | Print the four bundled skills with installed status + version |
| `first-tree skill doctor` | Diagnose skill-install health (exits non-zero on problems) |
| `first-tree skill link` | Idempotently repair `.claude/skills/*` alias symlinks |

The `install/upgrade/list/doctor/link` surface is the canonical entrypoint an
agent reaches for when the `first-tree` umbrella skill's **"Managing Skills On
This Machine"** section sends them here.

## Related

- Tests: [`tests/meta/skill-commands.test.ts`](../../../tests/meta/skill-commands.test.ts)
