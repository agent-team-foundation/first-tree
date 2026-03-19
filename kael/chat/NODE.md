---
title: Chat
owners: [yuezengwu]
---

# Chat

How users interact with Kael — sessions, streaming, message history, interactive flows, workspace UI.

- **[Streaming](streaming.md)** — SSE split-channel design (REST send / SSE receive), event types, pending messages, reconnection
- **[Frontend](frontend.md)** — UI architecture (container/presentation split), interactive features
- **[Channels](channels.md)** — multi-channel support (Web, Feishu, Desktop, CLI)
- **[Preview](preview/)** — file preview convention and dispatch infrastructure. How different file types are displayed in the workspace.

---

## Session Lifecycle

Sessions track both their own status and the agent's status independently:

- **Session status:** ACTIVE → STOPPED → CLOSED
- **Agent status:** IDLE → RUNNING → COMPLETED / DEFERRED / CANCELLED / FAILED

A session can be ACTIVE with the agent IDLE (waiting for user input), or ACTIVE with the agent RUNNING (processing). Users can cancel a running agent without closing the session.

soft_links: [/kael/agent, /kael/platform]
