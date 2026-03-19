---
title: Preview
owners: []
---

# Preview

How Kael displays file content to users — the shared convention and dispatch infrastructure for all file-type previews.

---

## Architecture

Preview is not a unified framework with a shared base component. It is a **convention**: each file type implements its own panel following the same pattern, and a central dispatch layer routes to the correct panel.

**Per-type implementation** (each file type has):
- A Panel component (`PdfPanel`, `SlidesPanel`, `ImagePanel`, …)
- A state management hook (`usePdfPanel`, `useSlidesPanel`, …)

**Shared infrastructure**:
- `usePanelResize` — resize logic shared across all panels
- `panel-constants.ts` — zoom constants
- `useProjectPageData.ts` — dispatch logic (routes by `document_type`)
- `workspace/page.tsx` — single render outlet; panels are mutually exclusive

## Supported File Types

| Type | Panel | Notes |
|------|-------|-------|
| PDF | `PdfPanel` | |
| Slides | `SlidesPanel` | See [slides.md](slides.md) for caching and loading detail |
| Image | `ImagePanel` | |
| Markdown / Text / HTML | `MarkdownPanel` | Workspace-generated docs |
| HTML (web page) | `HtmlPanel` | |
| Spreadsheet (CSV, XLSX, …) | `EditableSpreadsheetPanel` | |
| Generic | `GenericFilePanel` | No preview; shows icon only |

## Adding a New File Type

1. Create a `use{Type}Panel` hook for state management
2. Create a `{Type}Panel` component for rendering
3. Add dispatch logic in `useProjectPageData.ts`
4. Add conditional render in `workspace/page.tsx`
