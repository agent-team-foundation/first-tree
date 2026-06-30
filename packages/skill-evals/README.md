# First Tree Skill Evals

Opt-in live model evaluations for First Tree skills. These scripts are not part
of `pnpm test`, `pnpm check`, or default CI because they can consume real model
quota.

## Commands

```bash
pnpm --filter @first-tree/skill-evals eval:floor
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-read
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-read --case tree-software-trigger
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write --include-quality
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-welcome
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-seed
pnpm --filter @first-tree/skill-evals eval:quality
pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-write
pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-welcome --judge-model <model>
pnpm --filter @first-tree/skill-evals eval:select -- --base main
pnpm --filter @first-tree/skill-evals eval:summary
pnpm --filter @first-tree/skill-evals eval:compare
```

`eval:floor` is a no-model check for the skill-eval framework itself. It
validates that all shipped First Tree skills are present in the coverage
matrix, their `SKILL.md` frontmatter is readable, and their case declarations
have the minimum schema required by the shared runner. It does not execute
Codex, Claude Code, LLM-as-judge, or live gate cases.

`eval:select` is a no-model helper for local development and PR review. It
looks at changed files and recommends the smallest relevant eval commands:

```bash
pnpm --filter @first-tree/skill-evals eval:select -- --base main
pnpm --filter @first-tree/skill-evals eval:select -- --changed-file skills/first-tree-write/SKILL.md
pnpm --filter @first-tree/skill-evals eval:select -- --base main --json
```

The selector is intentionally conservative for shared skill-eval
infrastructure: core runner or schema changes recommend floor plus all
implemented deterministic gates, and judge-core changes also recommend quality.
Suite or skill changes recommend that suite's floor/gate/quality coverage where
implemented. The command only recommends; live gate and quality evals remain
opt-in and are not part of `pnpm test`.

`eval:quality` is an opt-in LLM-as-judge layer. It does not replace
deterministic gates and is not called by `eval:gate` by default. Each quality
case first runs the corresponding live gate case and requires that deterministic
gate to pass; only then does it send the actual produced artifact to the judge.
For write and welcome gates, `eval:gate -- --include-quality` runs the
deterministic gate first and then reuses that same gate artifact for the
supported quality case. If the deterministic gate fails, the judge is not run.
`--include-quality` is intentionally rejected for read and seed suites. The
first quality cases judge:

- `first-tree-write` node quality from the actual `durable-source-writes` tree
  diff, with scores for durability, source-boundary discipline, rationale
  quality, and conciseness;
- `first-tree-welcome` first-task quality from the actual readable-repo +
  populated-tree row output, with scores for evidence grounding, boundedness,
  usefulness, verifiability, and avoiding setup-as-task.

The quality runner calls Codex as the judge by default. Use `--judge-model` or
`JUDGE_MODEL` to select the judge model, and `--judge-bin` or `JUDGE_CODEX_BIN`
to select the Codex binary. Judge output must be strict JSON; invalid JSON or a
schema mismatch fails the quality case rather than being treated as a pass.
The Codex judge runs with a read-only sandbox, ignored user config/rules, an
isolated `HOME` / temp directory, an environment allowlist, and failing command
guards for common external side-effect commands such as `git`, `gh`,
`first-tree`, `curl`, and `wget`. This is a guardrail for the text judge; it is
not a substitute for a future direct no-tools judge API.

`eval:gate -- --suite first-tree-read` runs the live Codex gate for
`first-tree-read`. It covers the existing read cases through the shared gate
runner:

- blank workspace + casual prompt should not trigger Context Tree reads;
- Context Tree workspace + software prompt should read the skill, inspect
  `first-tree tree tree --help`, use a selector successfully, and report the
  expected durable facts;
- Context Tree workspace + non-software prompt should not use `first-tree`.

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

`eval:gate -- --suite first-tree-seed` runs the live Codex gate for
`first-tree-seed`. It covers the minimum bootstrap lifecycle boundaries:

- empty tree + present bare source proposes only Phase 1 skeleton for user
  approval;
- non-empty tree refuses seed and points to incremental write or focused
  maintenance;
- missing source clone stops on incomplete provisioning instead of partial
  seed;
- bare source repos are read through a materialized read worktree, not as
  checkouts.

The runner creates isolated temporary workspaces under
`packages/skill-evals/.runs/<timestamp>-<case-id>/`, installs
the relevant skill, prepends command shims such as `first-tree` to `PATH`, and
runs `codex exec --json` from the case workspace for live eval commands.
Fixture validation runs `tree verify` through the per-run `first-tree` shim by
default. To validate fixtures with an installed channel binary instead, set
`FIRST_TREE_EVAL_VERIFY_BIN` to the desired executable, for example
`FIRST_TREE_EVAL_VERIFY_BIN=first-tree-staging`.
Live gate runs do not inherit the operator's full environment. The Codex
process receives an allowlisted environment plus an isolated `HOME`, temp
directory, and XDG cache/config directories under the case run root. The model
shell runs with `shell_environment_policy.inherit=none`, only the eval shims and
isolated paths are set explicitly, and Codex is invoked with
`--ignore-user-config`, `--ignore-rules`, and `--sandbox workspace-write`.

Each case writes:

- `events.jsonl` with harness events, Codex JSONL events, and shimmed
  `first-tree` invocations.
- `grading.json` with deterministic four-axis gate grading:
  `routing_pass`, `process_pass`, `outcome_pass`, and `risk_pass`, plus
  evidence and risk flags.
- `summary.json` with derived metrics.
- `summary.md` with a human-readable case report and grading summary.

The top-level `eval:floor`, `eval:gate`, and `eval:quality` commands also append
a lightweight local result-store entry to
`packages/skill-evals/.runs/index.jsonl`. Entries record the run group, suite,
tier, case, pass/fail state, git branch/sha, model/provider where available,
artifact paths, duration, turns and first-response latency when derivable, cost,
and judge scores when present. Gate failures use the deterministic grading
evidence first and link the `grading.json` artifact path in the result store.
Unknown turn or latency values are recorded as `null`. The `.runs` directory is
gitignored local eval state.

Use `eval:summary` to summarize the latest result-store run group, or pass a
specific run group id:

```bash
pnpm --filter @first-tree/skill-evals eval:summary
pnpm --filter @first-tree/skill-evals eval:summary -- --json
pnpm --filter @first-tree/skill-evals eval:summary -- --current <run-group-id>
```

The summary is read-only. It reports pass/fail counts, failures, artifact
paths, derived turns and first-response latency, and a lightweight flaky status:
either "not enough comparable history", "stable", or status flips based on the
previous comparable run group.

Use `eval:compare` to compare the latest result-store run group with the
previous one:

```bash
pnpm --filter @first-tree/skill-evals eval:compare
pnpm --filter @first-tree/skill-evals eval:compare -- --json
pnpm --filter @first-tree/skill-evals eval:compare -- --current <run-group-id> --previous <run-group-id>
```

The comparison highlights new failures, recoveries, cases still failing, cases
still passing, score deltas for judge-backed cases, and artifact paths. If there
is no previous run group yet, the command prints a clear "not enough runs"
message instead of failing with a low-level store error.

Quality cases also write `judge-prompt.txt` and `judge-raw-output.txt` in the
case run directory, and include `judge_scores`, `judge_reasoning`,
`judge_model`, duration, thresholds, and failure reasons in `summary.json`.

Use `--verbose` to print live, human-readable progress to stderr. It can be
combined with `--case`, `--validate-fixtures`, and `--json`; stdout remains the
final summary table or aggregate JSON.

Fixture-only validation is available without model calls:

```bash
pnpm --filter @first-tree/skill-evals validate:first-tree-read-fixtures
```

Legacy read eval aliases are retained for compatibility, but the shared gate
command is the primary live path:

```bash
pnpm --filter @first-tree/skill-evals eval:first-tree-read
pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --case tree-software-trigger
pnpm --filter @first-tree/skill-evals eval:first-tree-read -- --case tree-software-trigger --validate-fixtures --verbose
```
