# First Tree Skill Evals

Opt-in live model evaluations for First Tree skills. These scripts are not part
of `pnpm test`, `pnpm check`, or default CI because they can consume real model
quota.

## first-tree-read

```bash
pnpm --filter @first-tree/skill-evals eval:first-tree-read
pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --case tree-software-trigger
pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --json
pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --verbose
pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --case tree-software-trigger --validate-fixtures --verbose
```

The runner creates isolated temporary workspaces under
`packages/skill-evals/.runs/<timestamp>-<case-id>/`, installs
`first-tree-read`, prepends a `first-tree` shim to `PATH`, and runs
`codex exec --json` from the case workspace.

Each case writes:

- `events.jsonl` with harness events, Codex JSONL events, and shimmed
  `first-tree` invocations.
- `summary.json` with derived metrics.
- `summary.md` with a human-readable case report.

Use `--verbose` to print live, human-readable progress to stderr. It can be
combined with `--case`, `--validate-fixtures`, and `--json`; stdout remains the
final summary table or aggregate JSON.

Fixture-only validation is available without model calls:

```bash
pnpm --filter @first-tree/skill-evals validate:first-tree-read-fixtures
```

## first-tree-write

```bash
pnpm --filter @first-tree/skill-evals eval:first-tree-write
pnpm --filter @first-tree/skill-evals eval:first-tree-write -- --case write-source-trigger
pnpm --filter @first-tree/skill-evals eval:first-tree-write -- --case read-and-write-installed-read-trigger --verbose
pnpm --filter @first-tree/skill-evals eval:first-tree-write -- --json
pnpm --filter @first-tree/skill-evals eval:first-tree-write -- --case write-source-trigger --validate-fixtures --verbose
```

The runner creates isolated temporary workspaces, installs the repo-local
`first-tree-write` skill and, for dual-skill cases, `first-tree-read`, then
runs `codex exec --json` with a shimmed `first-tree` binary.

Expected trigger-case evidence:

- `first-tree-write/SKILL.md` was loaded from the workspace skill install.
- `first-tree tree tree` succeeded during the model phase.
- The expected target path, currently `systems/server/auth/jwt`, appeared in a
  tree listing or in the model's stated planned target after a successful tree
  listing.
- Model-phase `first-tree` commands returned zero.

Expected non-trigger evidence:

- `first-tree-write/SKILL.md` was not loaded.
- No write-specific target selection or write intent appears in the final
  output.
- Dual-skill read-only cases may use `first-tree-read` and `first-tree tree
  tree`, but must still avoid the write skill.

Fixture-only validation is available without model calls:

```bash
pnpm --filter @first-tree/skill-evals validate:first-tree-write-fixtures
```
