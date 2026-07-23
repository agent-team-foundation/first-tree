# Evidence and Judgment Schema

Use this reference while reviewing `candidates.jsonl` and authoring
`judgments.jsonl`. The bundled script owns collection and validation; do not
manually rewrite collected passages or timestamps.

## Candidate evidence

`collect` emits one JSON object per authorized Chat-Agent audit unit:

```json
{
  "schema_version": 1,
  "audit_id": "CHAT_UUID@AGENT_UUID",
  "chat": {
    "chat_id": "UUID",
    "title": "Chat topic",
    "authorization": "owned",
    "source_agent": "agent-name",
    "source_agent_id": "agent-uuid",
    "message_count": 12
  },
  "window": {
    "start": "RFC3339",
    "end": "RFC3339"
  },
  "candidate_status": "candidate",
  "mapped_trace_files": ["/local/path/to/session.jsonl"],
  "reads": [
    {
      "read_id": "stable-id",
      "timestamp": "RFC3339",
      "completed_at": "RFC3339",
      "session_file": "/local/path/to/session.jsonl",
      "call_id": "provider-call-id",
      "tool_name": "exec_command",
      "reader_agent_id": "agent-uuid",
      "node_paths": ["system/example.md"],
      "content_class_hint": "normal",
      "command": "recorded tool input",
      "passage": "actual recorded tool output",
      "passage_truncated": false,
      "success": true
    }
  ],
  "visible_choice_candidates": [
    {
      "message_id": "message-id",
      "created_at": "RFC3339",
      "sender_id": "sender-id",
      "content": "visible later output"
    }
  ],
  "visible_tree_mentions": [],
  "coverage_gaps": []
}
```

`content_class_hint` is path-based triage, not a semantic verdict. Confirm that
the cited passage itself is decision-bearing normal content. A composite tool
output can contain both qualifying and non-qualifying material. `node_paths`
are resolved relative to an explicitly authorized bound Tree root, so arbitrary
team domain names are supported.

`reads` contains only traces whose exact workspace is bound to
`reader_agent_id`, and that ID must equal the evidence unit's
`source_agent_id`. The collector independently verifies that workspace binding
against `.first-tree-workspace/identity.json`; the command-line mapping is not
trusted by itself. `visible_choice_candidates` contains only messages whose
`sender_id` equals the same audited Agent. Human and other-Agent activity
cannot prove this Agent's influence, even in a shared Chat.

`outside_candidate_set` means no successful Tree content read and no visible
Tree influence signal were found. It is not `unproven`, ineligible, or a
negative result.

## Judgment evidence

Create exactly one JSONL row for every `candidate`:

```json
{
  "audit_id": "CHAT_UUID@AGENT_UUID",
  "result": "verified",
  "effect": "constrained",
  "rubric": {
    "real_read": true,
    "decision_bearing_normal_passage": true,
    "task_relevant": true,
    "read_before_choice": true,
    "influence_visible": true
  },
  "read_ids": ["stable-read-id"],
  "choice_message_ids": ["message-id"],
  "decision_theme": "One concise theme",
  "summary": "The passage constrained the implementation to one existing state source.",
  "representative": true,
  "coverage_gaps": []
}
```

Allowed results:

- `verified`: every rubric field must be `true`.
- `probable`: the first four fields must be `true` and
  `influence_visible` must be `null` or `false`.
- `unproven`: evidence does not close the claim. Set `effect` to `null`.

Allowed effects for `verified` and `probable`:

- `confirmed`: corroborated an already selected direction.
- `constrained`: narrowed scope or prevented an invalid extension.
- `redirected`: changed the proposed direction or implementation path.
- `conflicted`: exposed a conflict between the choice and authoritative normal
  content.

Use `null` for a genuinely unknowable rubric fact and `false` for contrary
evidence. Do not use `probable` to soften a failed real-read, normal-content, or
task-relevance check. Both positive results require at least one successful
`read_id` and one audited-Agent `choice_message_id`. When
`read_before_choice` is true, the reporter verifies that every cited read
has a completion timestamp and completed no later than the earliest cited
choice. A known post-choice read cannot be positive evidence.

## Review order

For each candidate:

1. Open the referenced read and verify the tool output contains the stated
   passage.
2. Identify the exact decision-bearing normal claim. Indexes, workflow
   instructions, member routing, archives, and proposals cannot qualify alone.
3. Explain the concrete task choice the claim could affect.
4. Compare read and visible-message timestamps.
5. Cite the later message ID that exposes the effect.
6. Choose the conservative result and record any missing or truncated evidence
   in `coverage_gaps`.

Do not infer hidden reasoning. An aligned outcome without visible causality is
at most `probable`.
