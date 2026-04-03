---
title: "File Tools (file_*)"
owners: [286ljb, baixiaohang]
soft_links: [/kael/platform/project-asset-system.md]
---

# File Tools (file_*)

Four tools for reading, linking, downloading, and presenting files. All file references use **URI scheme notation** to make the storage backend explicit at the call site.

---

## URI Schemes

| Scheme | Format | Resolves to |
|--------|--------|-------------|
| `file://` | `file://{asset_id}` | Project asset by database ID |
| `project://` | `project://{filename}` | Project asset by filename (any type) — not surfaced in `<file_context>`; use when filename is known from another source |
| `external://` | `external://{filename}` | `EXTERNAL` asset by filename |
| `artifact://` | `artifact://{filename}` | `ARTIFACT` asset — files Kael created in the sandbox |
| `internal://` | `internal://{filename}` | `INTERNAL` (system-derived) asset |
| `sandbox://` | `sandbox:///{abs_path}` | Sandbox filesystem (not in database) |
| `desktop://` | `desktop:///{abs_path}` | User's local machine (requires desktop app + access grant) |
| _(bare path)_ | `/path/to/file` | Treated as sandbox path (legacy) |

**Asset Types** (stored in `project_assets` table):

| Type | Origin | Description |
|------|--------|-------------|
| `EXTERNAL` | User upload, web download | Files brought in from outside |
| `ARTIFACT` | Kael or user created | Files produced inside the project |
| `INTERNAL` | System | Derived/processing files |
| `REFERENCE` | — | References to content stored in another system (e.g. slides) — cannot be read as plain file |

---

## `file_read`

Reads file content from any backend. Image files (detected from magic bytes) are returned as `BinaryContent` and rendered inline. Text files are returned as strings.

**Partial reads** via `mode` parameter:

| Mode | Behavior |
|------|----------|
| `None` (default) | Full content. Auto-truncates to last N chars if large |
| `"head"` | First N chars |
| `"tail"` | Last N chars |
| `"start_index"` | N chars starting at `start_index` |

**Notable behaviors:**
- `REFERENCE` assets (slides) are blocked — use `slides_get_content` or `file_present` instead.
- `artifact://` falls back to sandbox workspace path if the filename is not in the database.
- Desktop files route through the desktop app with resource access control.

---

## `file_get_url`

Returns a stable URL for a project asset that can be embedded in Markdown:

- `purpose="display"` → URL with content hash for cache-busting: `/files/{id}/content?v={hash}`
- `purpose="download"` → URL that triggers browser download: `/files/{id}/content?download=true`

Only works with project asset schemes (`file://`, `project://`, `external://`, `artifact://`, `internal://`). Desktop and sandbox files have no accessible URLs.

Always embed the returned URL in Markdown:
- Image: `![caption](url)`
- Download: `[filename](url)`

---

## `file_download`

Downloads a file from an HTTP/HTTPS URL into the project as an `EXTERNAL` asset.

- Streams in chunks, max 100 MB
- Deduplicates by content hash — same file downloaded again returns the existing asset
- Triggers background ingestion (parsing, indexing) for supported types (PDF, PPTX, etc.)
- Reports download progress at 10% intervals via `send_message`

---

## `file_present`

Presents files to the user by opening the Preview Panel.

- Sends a `present_files` event to the frontend
- First previewable file is auto-opened (PDF, HTML, Markdown, Slides, plain text)
- `REFERENCE` assets (slides) use a slides-specific renderer
- Use this after creating files the user should see — PDFs, HTML reports, exported docs

---

## How the Agent Knows About Files

File URIs don't appear from nowhere — the agent learns about available files through the **file context injection** mechanism: a `<file_context>` block is prepended to the first user message, and `<file_update>` blocks carry incremental changes on subsequent messages. This is documented in [file-context.md](file-context.md).

---

## Decision Log

**2026-02** — Migrated file references from `document_id` to URI scheme notation. Eliminated ambiguity between asset ID spaces and made file type explicit at the call site. Backward compatibility in `file_context.py` via `_normalize_snapshot()`.

**2026-02** — `file_get_url` added as a separate tool from `file_read`. Agents were embedding presigned S3 URLs that expired. Stable relative URLs with content hash solve this.

**2026-03** — `file_read` gained `head`/`tail`/`start_index` modes to handle large files without loading full content into context. Default auto-truncates to tail.
