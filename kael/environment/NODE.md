---
title: Environment
owners: [286ljb]
---

# Environment

How Kael acts on the world. Three execution environments, each connected to the backend:

- **[Browser](browser.md)** — control Chrome tabs via a browser extension (kael-browser-extension)
- **[Desktop](desktop.md)** — execute shell commands and read files on the user's machine via a system tray app (kael-desktop)
- **[Sandbox](sandbox.md)** — run code in isolated cloud VMs via E2B

---

## Shared Patterns

All three environments follow the same architectural patterns.

### WebSocket Protocol

Browser and desktop connect to the backend via persistent WebSocket (`/ws/browser`, `/ws/desktop`). One connection per user. Messages use a JSON envelope: `{id, type, payload, timestamp}`.

Commands follow a **fire-and-wait** pattern: backend generates a UUID, sends a command, and blocks on an asyncio Future until the client responds with a matching result. This guarantees sequential execution — the agent doesn't proceed until it knows the outcome.

Sandbox uses a different connection model (direct E2B SDK calls), but the command-result pattern is the same.

### Confirmation Flow

When the agent attempts a risky action, the backend sends a confirmation request to the client. The client shows a dialog. The user approves or denies. The response resolves the pending Future.

**Fail-safe design:** timeout = denied, disconnection = denied, window closed = denied. The system never defaults to approved.

Desktop has a **dual-path confirmation**: the request is sent both to the desktop app (WebSocket dialog) and to the web frontend (SSE dialog). First responder wins; the other is cancelled. This ensures the user can approve from whichever surface is active.

### Resource Access Control

See **[resource-access.md](resource-access.md)** — the full check pipeline, per-environment coverage, and egress network policy.

### Context Injection

Each environment injects connection status into the agent's message context (e.g., `<desktop_context>Desktop app: Connected</desktop_context>`). These tags are stripped before displaying messages to the user in the frontend. This gives the agent awareness of which environments are available without leaking internal metadata to the UI.

### Tool Execution Pattern

All environment tools follow the same sequence:
1. Check client connection (is the extension/app/sandbox available?)
2. Check resource access (is the agent allowed to access this URL/path/command?)
3. Check safety (is this action safe, or does it need user confirmation?)
4. Execute command via the appropriate service
5. Process output (stream to frontend, store screenshots, truncate large output)
