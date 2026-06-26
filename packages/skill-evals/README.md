# First Tree Skill Evals

Opt-in live model evaluations for First Tree skills. These scripts are not part
of `pnpm test`, `pnpm check`, or default CI because they can consume real model
quota.

## first-tree-read

```bash
pnpm --filter @first-tree/skill-evals eval:floor
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-welcome
pnpm --filter @first-tree/skill-evals eval:first-tree-read
pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --case tree-software-trigger
pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --json
pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --verbose
pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --case tree-software-trigger --validate-fixtures --verbose
```

`eval:floor` is a no-model check for the skill-eval framework itself. It
validates that all shipped First Tree skills are present in the coverage
matrix, their `SKILL.md` frontmatter is readable, and their case declarations
have the minimum schema required by the shared runner. It does not execute
Codex, Claude Code, LLM-as-judge, or live gate cases.

`eval:gate -- --suite first-tree-write` runs the live Codex gate for
`first-tree-write`. It covers the minimum source-boundary cases:

- no source artifact means no Context Tree diff;
- durable source material can produce a minimal tree diff and must run
  `first-tree tree verify`;
- implementation-only source material means no Context Tree diff.

`eval:gate -- --suite first-tree-welcome` runs the live Codex gate for
the currently implemented `first-tree-welcome` onboarding rows:

- tree kickoff chat routes to the tree setup lane instead of welcome first-task
  options;
- no repo connected / intro chat asks for a local clone path or GitHub URL
  without requiring GitHub authorization first;
- readable repo + populated Context Tree reads both evidence sources and offers
  two or three bounded first-task options without seeding or setting up the
  tree.

The runner creates isolated temporary workspaces under
`packages/skill-evals/.runs/<timestamp>-<case-id>/`, installs
the relevant skill, prepends command shims such as `first-tree` to `PATH`, and
runs `codex exec --json` from the case workspace for live eval commands.

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
