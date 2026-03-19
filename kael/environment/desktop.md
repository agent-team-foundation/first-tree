---
title: Desktop Control
owners: [286ljb]
---

# Desktop Control

The agent executes shell commands and reads files on the user's machine through a Tauri 2 system tray app (Rust + React) connected to the backend via WebSocket.

---

## Shell Execution

Commands run in **persistent PTY sessions** — one long-lived bash process per session ID. This means state persists across commands: `cd` into a directory, `export` a variable, and subsequent commands see it. This is essential for multi-step workflows.

**Environment resolution:** On first launch, the app spawns a login shell to capture the user's full environment (PATH, conda, nvm, cargo, etc.), then applies it to all PTY processes. PTYs are started with `--norc --noprofile` to avoid re-entry into rc files.

**Output detection:** Since the PTY is persistent (no EOF between commands), output boundaries are detected using a marker-based protocol. Each command is wrapped with a unique end marker; the app distinguishes real output from echoed markers by content inspection. Exit codes are captured from the marker line.

**Limits:** 10 MB max output per command. Configurable timeout (default 120s, max 600s).

---

## File Reading

The agent can read files with four modes: full, head (first N lines), tail (last N lines), and range (offset + limit). Binary files are detected (null byte in first 8KB) and rejected. 10 MB max per read.

---

## Safety

Desktop safety has three layers (enforcement of policies defined in platform/):

1. **Static deny list** (hard block) — regex patterns blocking destructive commands: `rm -rf /`, `mkfs`, `dd` to disk, fork bombs, `sudo`, `chmod 777 /`, piped remote execution (`curl | sh`). This list is enforced on **both** backend and desktop app as defense-in-depth.

2. **Safe command set** (auto-approve) — read-only commands (ls, cat, grep, git status, etc.) are auto-approved. Unsafe constructs ($(), backticks, redirects) disqualify a command from the safe set even if the base command is safe.

3. **LLM self-assessment** — same as browser: agent provides sensitivity classification, hard-confirm categories always need approval.

**Dual-path confirmation:** When user approval is needed, the request is sent to both the desktop app tray dialog and the web frontend SSE dialog. First response wins. This ensures the user can approve from whichever surface they're looking at.

soft_links: [/kael/platform]

---

## System Tray

The app runs as a system tray icon with dynamic status (connected/connecting/disconnected). The tray blinks when a confirmation request arrives. The window shows active sessions with interrupt/stop controls.

---

## Connection

WebSocket with exponential backoff reconnection (1s → 60s cap). 30-second heartbeat pings. Auth code 4001 means token expired — no reconnect until re-authenticated.

Authentication uses a localhost callback server (OS-assigned port) with state nonce for CSRF protection. JWT is stored in Tauri plugin-store. 120-second timeout for the user to complete the browser-based login flow.
