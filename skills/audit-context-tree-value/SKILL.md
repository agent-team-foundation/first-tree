---
name: audit-context-tree-value
description: Reconstruct how Context Tree passages influenced past agent decisions when a human explicitly asks for a retrospective value audit such as “analyze what value Context Tree created in my agents’ work over the past seven days.” Use only for a manual, read-only historical audit of Chats the current user owns or explicitly authorizes. Do not use for ordinary task context reads, stored-tree health audits, source-backed Tree writes, automatic monitoring, or generic Chat analytics.
---

# Audit Context Tree Value

## Purpose

Produce a conservative, passage-level audit from authorized First Tree Chat
history and local Codex traces. Keep deterministic collection separate from
Agent judgment: the script proves what was read and what was visible later; the
Agent decides whether the passage influenced a choice.

This workflow is manual and read-only. Do not modify Chat history, traces,
Context Tree content, product state, schedules, or server schemas. Keep every
generated artifact inside the triggering Agent workspace.

## Scope Gate

1. Confirm that a human explicitly requested a historical Context Tree value
   audit. Do not infer this workflow from a normal engineering task, a routine
   `first-tree-read`, or a request to audit stored Tree quality.
2. Default the window to seven days. Accept a different positive `--days`
   value when requested.
3. Build an explicit scope containing only:
   - Codex agents shown as managed by the current user and configured on this
     machine; or
   - Chat IDs the user explicitly authorized in the request, including the
     runtime-injected current `chatId`.
4. Use `first-tree agent list --remote` and local `first-tree agent list` only
   to verify owned Codex agents and resolve the exact local Agent UUID. The
   exporter consumes their machine-readable UUIDs, repeats the local
   alias/UUID/runtime check for every scope entry, and additionally verifies
   exact remote ownership before expanding an Agent to its Chat list. Do not
   treat every visible Team agent or Chat as authorized. Never enumerate
   unrelated agents in the background.
5. Record the basis as `owned` or `explicit` in a scope JSON file. If ownership
   or authorization is ambiguous, narrow to the current Chat or ask the human.

Use this shape:

```json
{
  "schema_version": 1,
  "agents": [
    {
      "name": "owned-codex-agent",
      "agent_id": "00000000-0000-0000-0000-000000000001",
      "authorization": "owned"
    }
  ],
  "chats": [
    {
      "chat_id": "00000000-0000-0000-0000-000000000000",
      "agent": "agent-that-can-read-the-chat",
      "agent_id": "00000000-0000-0000-0000-000000000001",
      "authorization": "explicit"
    }
  ]
}
```

An agent entry authorizes the read-only Chat list for that owned agent. A Chat
entry authorizes only that exact Chat. Do not use a broad agent entry merely
because one of its Chats was authorized. Agent entries must use `owned`; Chat
entries must use `explicit`. The UUID identifies which visible messages were
authored by the audited Agent, so derive it from local configuration and never
guess or substitute another participant. Each evidence unit is one exact
`Chat UUID @ Agent UUID` pair; a shared Chat is audited separately per scoped
Agent so one Agent's read cannot be paired with another Agent's choice.

## Deterministic Collection

Create a timestamped artifact directory under the triggering Agent workspace,
then locate this skill directory and run its bundled script:

```bash
python3 scripts/audit_context_tree_value.py export-chats \
  --artifact-root "$AUDIT_DIR" \
  --scope "$AUDIT_DIR/scope.json" \
  --days 7 \
  --output "$AUDIT_DIR/chats.jsonl"

python3 scripts/audit_context_tree_value.py collect \
  --artifact-root "$AUDIT_DIR" \
  --chats "$AUDIT_DIR/chats.jsonl" \
  --days 7 \
  --agent-workspace "00000000-0000-0000-0000-000000000001=/absolute/authorized/agent/workspace" \
  --tree-root "/absolute/authorized/bound/context-tree" \
  --output "$AUDIT_DIR/candidates.jsonl"
```

Repeat `--agent-workspace` for each scoped Agent and bind its exact UUID to its
workspace. The set must exactly equal the scoped Agent UUIDs, and the collector
fails closed unless each workspace's non-symlinked
`.first-tree-workspace/identity.json` binds the same Agent UUID. Resolve each
workspace's exact bound Context Tree root from its managed workspace
configuration or runtime Tree Location, and repeat `--tree-root` when different
Trees are in scope. Never infer Tree domains or rely on a directory merely
named `context-tree`. Use `--trace-root` only to override the safely resolved
`CODEX_HOME/sessions` or `~/.codex/sessions`. Use `--now` for reproducible
reruns.

The scope gate uses read-only `agent list`; the exporter calls only read-only
`chat list` and `chat history` surfaces already available to the current user.
The collector:

- maps trace turns to Chats only through the runtime-injected `chatId`;
- reads only metadata first, then rejects non-First-Tree, non-Codex, subagent,
  or out-of-scope workspace traces before scanning trace content;
- streams accepted trace rows and retains only in-scope Tree reads,
  continuations, and their bounded outputs;
- pairs Codex tool calls with their outputs, including yielded shell
  continuations and `exec` / `wait` cells;
- records exact node paths, the actual returned passage, read time, and later
  visible audited-Agent message candidates;
- records missing, cleaned, malformed, unsupported, failed, or truncated trace
  evidence as coverage gaps.

Do not replace historical tool output with the current Tree file. Current
content may have changed and is not proof of what the Agent saw.

## Passage-Level Judgment

Read [references/evidence-schema.md](references/evidence-schema.md) before
creating judgments. Review every row whose `candidate_status` is `candidate`;
do not classify `outside_candidate_set` rows as failures.

For each candidate, inspect the cited passage and subsequent visible choice.
Apply all five rubric checks:

1. `real_read`: a successful tool output contains Tree Markdown content.
2. `decision_bearing_normal_passage`: the actual passage carries a current
   decision, constraint, rationale, or cross-domain relationship in normal
   content.
3. `task_relevant`: that passage could affect a concrete choice in this task.
4. `read_before_choice`: the read precedes the cited choice.
5. `influence_visible`: later visible output shows the passage confirmed,
   constrained, redirected, or conflicted with that choice.

Classify:

- `verified`: all five checks are true.
- `probable`: the first four are true and the outcome aligns, but visible
  causality remains incomplete.
- `unproven`: the available records do not meet the bar. This is not proof of
  no value.

Assign one effect only to `verified` or `probable`:
`confirmed`, `constrained`, `redirected`, or `conflicted`. Prefer the strongest
observable effect. Do not count a read, selector, workflow load, index,
member/owner route, proposal, or process instruction as value by itself.

Write `judgments.jsonl` using only IDs present in `candidates.jsonl`. Keep raw
passages local; summarize them rather than copying long content into the final
Markdown report.

## Finalize and Report

Run the deterministic validator/reporter:

```bash
python3 scripts/audit_context_tree_value.py report \
  --artifact-root "$AUDIT_DIR" \
  --candidates "$AUDIT_DIR/candidates.jsonl" \
  --judgments "$AUDIT_DIR/judgments.jsonl" \
  --evidence-output "$AUDIT_DIR/evidence.jsonl" \
  --report-output "$AUDIT_DIR/REPORT.md"
```

The command fails closed on missing candidate judgments, invalid rubric/result
combinations, evidence-free positive results, invalid read-before-choice
timing, or references to unknown read/message IDs. Every command confines all
inputs and outputs to `--artifact-root`, rejects symlink traversal, and writes
outputs atomically.

Report:

- `verified`, `probable`, and `unproven` counts by Chat-Agent audit unit;
- effect distribution and verified constraint hits;
- representative passage-to-choice cases;
- authorized Chat, message, mapped-trace, candidate, and judgment coverage;
- every material coverage gap and the V0 local-Codex boundary.

State explicitly that the full set of authorized Chats is not an eligible
denominator.
Tasks with no relevant decision-bearing Tree content cannot be reconstructed
reliably from historical records. Never present file-read counts, candidate
counts, or verified/all-Chat ratios as a value rate.

## Completion

Return links to `REPORT.md` and `evidence.jsonl`, the exact window and scope,
and any coverage limitation that materially changes interpretation. Keep all
artifacts in the triggering Agent workspace. Do not create a Tree write,
receipt, schedule, Context Tab change, database record, or provider adapter.
