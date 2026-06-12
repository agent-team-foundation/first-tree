# Context Tree Git-Based Write Detection

## Goal

Detect Context Tree writes that do not carry reliable tool-level file refs, especially shell redirection, heredocs, scripts, and other mutation paths that cannot be handled safely by expanding the shell parser.

The live Context tab feed remains a high-signal activity surface, not an audit log. Git history and the change map remain the authoritative write history. This detector only fills attribution gaps for agent-originated write activity.

## Recommended Design

Use the tree clone's git status as the write source of truth for local agent sessions:

1. Capture a clean baseline of Context Tree working-tree state for each active `(agentId, chatId, sessionId)` before tool execution begins.
2. After each successful tool call, run a bounded git status check against the bound tree clone.
3. Diff the current dirty-path set against the session baseline.
4. For newly dirty paths, emit synthetic Context Tree IO write events attributed to the active agent/chat/tool call.
5. Update the session baseline to the current dirty-path set after recording so one write is not emitted repeatedly.

This covers writes regardless of mechanism while avoiding command parsing for mutations.

## Attribution Model

Shared tree clones make directory-level git status ambiguous: two agents can dirty the same clone at the same time. The detector should therefore be session-scoped and conservative:

- Attribute a dirty-path delta only to the currently completing tool call for that session.
- Do not attribute paths that were already dirty in the session baseline.
- If multiple live sessions are active against the same tree clone, include a `metadata.attribution = "git_status_delta"` marker and the source tool id, but do not claim stronger causality than the time window supports.
- If the baseline cannot be captured, skip synthetic write detection for that session and log a structured skip reason.

This accepts rare concurrency ambiguity while preventing the much larger false positive of assigning pre-existing dirty files to a later agent.

## Hook Point

Run detection after successful tool calls, not only at turn end.

Per-tool-call detection is more expensive than turn-end detection, but it gives the feed useful attribution and avoids collapsing a multi-step edit sequence into one coarse turn-level event. The check is bounded to the tree clone and can be skipped when the previous tool call already left no baseline or when no Context Tree binding exists.

Turn-end-only detection remains a fallback if per-tool-call cost is too high in production telemetry, but it should not be the first implementation.

## Synthetic Event Shape

Synthetic rows should reuse `context_tree_io_events` rather than adding a second feed source table.

Recommended fields:

- `action`: `write`
- `source`: add a new shared enum value, `git_status_delta`
- `targetKind`: `file` for changed files, `directory` only if git status cannot resolve a file path
- `targetPath`: repo-relative path from git status
- `sourceSessionEventId`: the successful tool-call event id that triggered detection
- `sourceIndex`: an offset after any normal file-ref-derived rows for the same event
- `metadata`: include `{ "origin": "git_status_delta", "toolName": "...", "toolUseId": "..." }`

The unique `(sourceSessionEventId, sourceIndex)` index continues to provide idempotency.

## Open Implementation Checks

- Confirm whether the client always knows the tree clone path for Codex and Claude sessions after workspace bootstrap.
- Measure git status latency on large tree repos before deciding whether to debounce.
- Decide whether deletion-only deltas should use `targetKind: "file"` with the deleted path or a separate metadata flag. The current recommendation is file path plus `metadata.gitStatus`.
- Keep human/GitHub-authored changes out of this detector; those belong to git-backed change map and snapshot updates.
