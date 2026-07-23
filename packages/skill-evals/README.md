# First Tree Skill Evals

Human-directed live model evaluations for First Tree skills. These scripts are
not part of `pnpm test`, `pnpm check`, or default CI because they can consume
real model quota.

Agents run only no-model code checks such as `eval:floor` by default.
`eval:gate`, `eval:quality`, `eval:periodic`, `--include-quality`, and any
equivalent model-backed case require an explicit human instruction.
`eval:select` therefore recommends only floor commands.

## Commands

```bash
pnpm --filter @first-tree/skill-evals eval:floor
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-read
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-qa
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-read --case tree-software-trigger
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write --include-quality
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-welcome
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-seed
pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-seed --include-quality
pnpm --filter @first-tree/skill-evals eval:gate -- --suite context-tree-review
pnpm --filter @first-tree/skill-evals eval:gate -- --suite context-tree-audit
pnpm --filter @first-tree/skill-evals eval:periodic
pnpm --filter @first-tree/skill-evals eval:periodic -- --suite first-tree-read
pnpm --filter @first-tree/skill-evals eval:periodic -- --suite first-tree-seed
pnpm --filter @first-tree/skill-evals eval:periodic -- --suite first-tree-welcome
pnpm --filter @first-tree/skill-evals eval:quality
pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-seed
pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-write
pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-welcome --judge-model <model>
pnpm --filter @first-tree/skill-evals eval:select -- --base main
pnpm --filter @first-tree/skill-evals eval:summary
pnpm --filter @first-tree/skill-evals eval:compare
```

`eval:floor` is a no-model check for the skill-eval framework itself. It
validates that every eval-covered skill (`SHIPPED_SKILLS`) is present in the
coverage matrix, their `SKILL.md` frontmatter is readable, and their case
declarations have the minimum schema required by the shared runner. It does not
execute Codex, Claude Code, LLM-as-judge, or live gate cases. A shipped skill
may be intentionally left outside this harness by listing it in
`UNEVALUATED_SHIPPED_SKILLS`; the `shipped-skill-inventory` test enforces that
every on-disk `skills/*/` payload is either eval-covered or explicitly excluded,
so nothing escapes both.

`eval:select` is a no-model helper for local development and PR review. It
looks at changed files and recommends the smallest relevant floor commands:

```bash
pnpm --filter @first-tree/skill-evals eval:select -- --base main
pnpm --filter @first-tree/skill-evals eval:select -- --changed-file skills/first-tree-write/SKILL.md
pnpm --filter @first-tree/skill-evals eval:select -- --base main --json
```

The selector never recommends model-backed execution. Suite or skill changes
select the corresponding floor; shared runner, provider, judge, generated
briefing, or eval-framework changes select the all-suite floor. Live gate,
quality, and periodic commands remain available only when a human explicitly
requests them.

`eval:periodic` is the human-directed tier for broader, more expensive coverage
that is not suitable for default gates or ordinary CI. It accepts the same
basic live eval controls as gates, including `--suite`, `--case`, `--model`,
`--provider`, `--codex-bin`, `--claude-bin`, `--json`, and `--verbose`.
`first-tree-read` periodic runs a runtime-generated briefing fixture with the
installed First Tree skill topology; it is fixture coverage for the generated
briefing boundary, not a live First Tree Cloud/session E2E. `first-tree-welcome`
periodic runs the concrete setup-state matrix rows as live eval cases while
keeping the default welcome gate limited to its three high-risk rows.
`first-tree-seed` periodic runs a real-repo realism case that builds a per-run
bare source fixture from the current `first-tree` repo `HEAD` and still
requires the seed bare-source worktree protocol. `eval:periodic` with no
`--suite` runs all implemented periodic suites in one result-store run group.
Suites without implemented periodic cases still print a clear no-op summary and
exit 0. `eval:select` never recommends periodic; run it only on explicit human
instruction.

`eval:quality` is a human-directed LLM-as-judge layer. It does not replace
deterministic gates and is not called by `eval:gate` by default. Each quality
case first runs the corresponding live gate case and requires that deterministic
gate to pass; only then does it send the actual produced artifact to the judge.
For write, seed, and welcome gates, `eval:gate -- --include-quality` runs the
deterministic gate first and then reuses that same gate artifact for the
supported quality case. If the deterministic gate fails, the judge is not run.
`--include-quality` is intentionally rejected for read. The quality cases
judge:

- `first-tree-write` node quality from the actual `durable-source-writes` tree
  diff, with scores for durability, source-boundary discipline, rationale
  quality, and conciseness;
- `first-tree-seed` skeleton quality from the actual `empty-tree-source-present`
  Phase 1 proposal, with scores for source grounding, structure fit,
  phase-boundary discipline, coverage calibration, and conciseness;
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

`eval:gate -- --suite first-tree-qa` runs two complete-harness cases. One
blocks readiness when the Web observer is unavailable; the other proves that
both CLI and Web reach QA readiness before the requested CLI behavior is
planned and executed. Both grade source immutability, evidence, performance,
and final case disposition.

`eval:gate -- --suite first-tree-read` runs the live tested-agent gate for
`first-tree-read`. It covers the existing read cases through the shared gate
runner:

- blank workspace + casual prompt should not trigger Context Tree reads;
- Context Tree workspace + software prompt should read the skill, inspect
  `first-tree tree tree --help`, use a selector successfully, and report the
  expected durable facts;
- Context Tree workspace + non-software prompt should not use `first-tree`.

`eval:periodic -- --suite first-tree-read` runs
`first-tree-read-runtime-generated-briefing-periodic`. The fixture writes a
runtime-generated `AGENTS.md`/`CLAUDE.md` pair, installs the default First
Tree skill family, binds a deterministic Context Tree fixture, and then runs
the same read trigger oracle. This covers the generated-briefing and
skill-topology boundary only; real Cloud chat delivery, GitHub webhooks, and
live First Tree runtime E2E remain outside skill evals.

`eval:gate -- --suite context-tree-review` runs the repair-first Context Tree
pull request review gate. A task-local bare Git origin permits only an
allowlisted normal commit and fast-forward push to the PR source branch; a hook
mirrors that push to the local PR ref so the gate can require a dynamic
successor-head validation and complete re-review. A separate hook supplies the
push-denied case. The deterministic GitHub shim still permits only PR state
reads, identity lookup, and one body-file review submission, so no external
GitHub side effect is possible. Four repair scenarios cover validator repair,
semantic repair, mixed safe/protected findings, and push denial. The grader
uses structured shim events plus final Git/ref/content integrity to require one
decision-preserving scoped repair commit, the expected source-branch result,
successor validation and context review, current-head checks, and a verdict
that does not hand a safe repair back to the author. Existing cases retain
ready approval, draft deferral, archive-only scope, relationship expansion,
human authority, and stale-head suppression. The gate deliberately does not
interpret arbitrary shell wrappers or environment variants as a security
boundary; the production Skill carries the exact repair procedure, and formal
cross-surface QA owns the real GitHub/App/governance/merge chain. The fixture
runs the real source-tree validator for review and repair worktrees without
contacting GitHub.

`eval:gate -- --suite context-tree-audit` runs the manual, focused audit gate
against deterministic local default-branch fixtures. It requires the Audit
skill to own routing exclusively, fixes discovery to a clean detached remote
HEAD snapshot, replays a real source validator result before semantic reads,
and records every forge or human artifact through mocks. Cases cover a
mechanical focused PR, a strong evidence-backed write handoff, weak
cross-domain escalation, locked-decision authority, report-only zero mutation,
and missing-binding fail-closed behavior. This gate never performs a real
GitHub or First Tree external write.

`eval:gate -- --suite first-tree-write` runs the live tested-agent gate for
`first-tree-write`. It covers the minimum source-boundary cases:

- no source artifact means no Context Tree diff;
- durable source material can produce a minimal tree diff and must run
  `first-tree tree verify`;
- implementation-only source material means no Context Tree diff.

`eval:gate -- --suite first-tree-welcome` runs the live tested-agent gate for
the currently implemented `first-tree-welcome` gate rows:

- tree kickoff chat routes to the tree setup lane instead of welcome first-task
  options;
- no repo connected / intro chat asks for a local project folder path or GitHub repo URL
  without requiring GitHub authorization first;
- readable repo + populated Context Tree reads both evidence sources and offers
  two or three bounded first-task options without seeding or setting up the
  tree.

`eval:periodic -- --suite first-tree-welcome` runs the broader live welcome
matrix. It covers every concrete setup-state row from the current
`first-tree-welcome` matrix, including invitee not-ready/ready states, selected
repo authorization failure, local-readable repo with missing GitHub App,
installed app with no selected repo, readable repo with empty tree, and
readable repo with unknown tree. For the admin + readable repo + missing/empty
tree row, the welcome chat leads with evidence-backed code-first task options
and may also offer "Build your Context Tree" as a first-class menu option; it
must never seed, create, or bind the tree from the launcher itself — that side
effect stays forbidden. The explicit catch-all row remains a no-model
floor invariant because it is a structural fallback rather than a stable live
oracle. Periodic case ids use the gate row id plus `-periodic`; `--case` also
accepts the source row id as an alias.

`eval:gate -- --suite first-tree-seed` runs the live tested-agent gate for
`first-tree-seed`. It covers the minimum bootstrap lifecycle boundaries:

- empty tree + present bare source proposes only Phase 1 skeleton for user
  approval;
- non-empty tree refuses seed and points to incremental write or focused
  maintenance;
- missing source clone stops on incomplete provisioning instead of partial
  seed;
- an unbound workspace routes through `tree init --dir <managed tree path>`
  before Phase 1;
- bare source repos are read through a materialized read worktree, not as
  checkouts;
- an empty manifest may use a readable local checkout supplied in chat without
  requiring GitHub App installation or team-resource registration;
- a clean portable invocation with no Workspace manifest admits only its
  explicit Team, Tree path, and sources, while an ordinary member stops with
  stable Needs Admin before source or Tree work;
- a new process recovers an approved Phase 1 from the current bound branch,
  merged durable Seed marker, and canonical exact-commit source ledger without
  prior transcript or private cache state; and
- missing durable progress, source identity mismatch, unreadable recorded
  commit, or a changed binding each fail closed before Phase 2 mutation.

`eval:quality -- --suite first-tree-seed` runs the `empty-tree-source-present`
deterministic gate first. If that hard-rule gate passes, the quality judge
scores the actual Phase 1 skeleton proposal and source evidence. This judge is
human-directed and does not replace the deterministic seed gate: empty-tree
self-check, source boundary, bare worktree protocol, no tree/source/GitHub side
effects, and no Phase 2 leaf content before approval remain hard-rule oracle
conditions.

`eval:periodic -- --suite first-tree-seed` runs
`first-tree-seed-real-first-tree-source-periodic`. The fixture creates an empty
Context Tree plus a per-run bare source repo cloned from the current
`first-tree` repo `HEAD`. The model must still materialize
`worktrees/seed-source-repo`, read source evidence from that checkout, propose
only a Phase 1 skeleton, and ask for approval. This realism case stays in the
periodic tier and is not part of the default seed gate.

The runner creates isolated temporary workspaces under
`packages/skill-evals/.runs/<timestamp>-<case-id>/`, installs
the relevant skill, prepends command shims such as `first-tree` to `PATH`, and
runs the selected tested-agent provider from the case workspace for
human-directed live eval commands. Codex is the default provider. Use
`--provider claude --claude-bin <path>` for the Claude provider, or
`--provider codex --codex-bin <path>` to be explicit. Claude support is
validated by no-quota fake-binary tests by default; real Claude live evals
consume provider quota and require explicit human instruction.
Fixture validation runs `tree verify` through the per-run `first-tree` shim by
default. To validate fixtures with an installed channel binary instead, set
`FIRST_TREE_EVAL_VERIFY_BIN` to the desired executable, for example
`FIRST_TREE_EVAL_VERIFY_BIN=first-tree-staging`.
Live gate and periodic runs do not inherit the operator's full environment. The
selected provider receives an allowlisted environment plus an isolated `HOME`,
temp directory, and XDG cache/config directories under the case run root. The
Codex model shell runs with `shell_environment_policy.inherit=none`, only the
eval shims and isolated paths are set explicitly, and Codex is invoked with
`--ignore-user-config`, `--ignore-rules`, and `--sandbox workspace-write`.

Each case writes:

- `events.jsonl` with harness events, provider JSONL events, and shimmed
  `first-tree` invocations. Claude events are normalized into the existing
  event shape used by deterministic graders.
- `grading.json` with deterministic four-axis gate grading:
  `routing_pass`, `process_pass`, `outcome_pass`, and `risk_pass`, plus
  evidence and risk flags.
- `summary.json` with derived metrics.
- `summary.md` with a human-readable case report and grading summary.

The top-level `eval:floor`, `eval:gate`, `eval:periodic`, and `eval:quality`
commands append a lightweight local result-store entry to
`packages/skill-evals/.runs/index.jsonl`. Entries record the run group, suite,
tier, case, pass/fail state, git branch/sha, model/provider where available,
artifact paths, duration, turns and first-response latency when derivable, cost,
and judge scores when present. Gate failures use the deterministic grading
evidence first and link the `grading.json` artifact path in the result store.
Unknown turn or latency values are recorded as `null`. The `.runs` directory is
gitignored local eval state. Periodic live cases use
`command: "eval:periodic"` and `tier: "periodic"` entries so summary and compare
can report them alongside floor, gate, and quality runs. Periodic no-op paths
for suites with no implemented periodic cases do not append result-store
entries.

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
combined with `--case` and `--json`; stdout remains the final summary table or
aggregate JSON.
