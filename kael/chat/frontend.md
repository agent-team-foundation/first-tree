---
title: Frontend
owners: [yuezengwu]
---

# Frontend

The chat UI follows a **container/presentation split**:

- **`useKaelChat` hook** — orchestrates the full chat lifecycle: SSE subscription, message sending, pending tracking, auto-reconnection (exponential backoff, max 5 retries)
- **AI elements** (`src/ai-elements/`) — chat-specific components: message bubbles, tool call visualization, citation chips, streaming text renderer
- **Generic UI** (`src/ui/components/`) — Radix + Tailwind primitives shared across the app

---

## Interactive Features

- Tool call expanded view — users can inspect tool name, arguments, and result
- Inline citations with source popover — clickable references to documents and web pages
- File attachments — upload and reference files in conversation
- Structured response cards (AskCard) — agent presents choices for user selection
- Always-enabled input — user can type while agent is streaming
