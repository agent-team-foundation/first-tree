---
title: File Context Injection
owners: [286ljb, baixiaohang]
---

# File Context Injection

Before the agent replies to each user message, the system checks whether the project's files have changed. If they have, the agent receives a `<file_context>` or `<file_update>` block prepended to the user message. This is the mechanism by which the agent knows what files are available and can construct valid file URIs.

---

## Two Injection Modes

**First message in session** (`<file_context>`): The full current file list is injected, grouped by document type. This gives the agent a complete starting picture before any conversation.

**Subsequent messages** (`<file_update>`): Only changes since the last message are described (added/removed/status-changed documents, added/removed/modified workspace files), followed by the current full state. The agent does not need to re-read the full list — it receives a delta.

If nothing has changed since the last message, no block is injected.

---

## What the Agent Sees

**Project Documents** (EXTERNAL + REFERENCE assets) appear as:
```
- Document Title (file_uri: file://{asset.id}) [status]
```

Status displays:
- `✓` — ready to read
- `[Processing]` or `[Parsing, 42 pages, ~30s remaining]` — not yet usable
- `[Downloading]`, `[Retrying]` — in-progress
- `[Failed]` — unusable, surface this to the user

**Workspace Files** (ARTIFACT assets) appear as:
```
- filename.csv (file_uri: artifact://filename.csv)
```

The `file://` URI is constructed from the stable `asset.id`, not the filename, so it remains valid even if the file is renamed. ARTIFACT files use `artifact://` + relative path.

---

## Change Detection

The injector takes a snapshot of the current file state at the end of each message: a list of `{document_type, file_uri, title, status}` tuples for documents, and `{filename, content_hash}` pairs for workspace files.

On the next message, it diffs the new state against the saved snapshot using `(document_type, file_uri)` as the key for documents and `filename` for workspace files. `content_hash` change detection on workspace files catches user edits.

---

## Key Design Decisions

**Why prepend to user message instead of system prompt?** Documents are project-scoped, not workspace-scoped. Injecting per-message lets the same agent configuration work across any project without modifying the system prompt. It also lets the context update mid-conversation as files change.

**Why snapshot-based diffing?** The agent only needs to know what changed since the last message. Sending the full file list every time would be wasteful for projects with many files and would consume unnecessary context tokens.

**Why `asset.id` for documents but `filename` for workspace files?** Documents are immutable once parsed — their ID is stable and canonical. Workspace files are mutable and identified by path; `content_hash` catches edits to the same filename.

---

## Cross-Domain Links

- Asset types, URI schemes, status values: [../platform/project-asset-system.md](../platform/project-asset-system.md)
- Tools that read files using these URIs: [file-tools.md](file-tools.md)
