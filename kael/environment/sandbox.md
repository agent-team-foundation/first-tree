---
title: Sandbox
owners: [286ljb]
---

# Sandbox

The agent runs code in isolated E2B microVMs — full Linux environments with no access to the user's local machine.

---

## Why E2B Over Docker

E2B was chosen for: native microVM isolation (stronger than container process isolation), built-in VM snapshots (faster than container commits), lower operational complexity (managed service), and acceptable cold start (~150ms).

The sandbox layer uses a provider abstraction, so switching to Docker or another provider is possible without changing the agent tools or workspace logic.

---

## Session-to-Sandbox Mapping

Each chat session gets its own sandbox (1:1 mapping, persisted in database). The sandbox is created on first `sandbox_run` call, not on session creation.

**Lifecycle:** active → paused (after 60s idle, E2B freezes the VM) → resumed (on next command, exact state restored including open files and env vars). This avoids the cost of running idle sandboxes while preserving session state.

---

## Command Execution

Two modes:

- **Tmux runner** (primary) — writes command to a file, sends to tmux session, polls for exit marker. Only 2 E2B API calls per command, 37-51% faster than the alternative. Output is collected post-execution (not streamed in real-time).
- **Direct execution** (fallback) — uses E2B's `commands.run()` API. Supports real-time streaming. Used when tmux is unavailable (e.g., after sandbox pause/resume if tmux didn't recover).

Commands are serialized per sandbox (asyncio lock on tmux session) to prevent interleaving.

---

## Workspace and File Management

Each sandbox has a workspace at `/workspace/project/` with a structured file system:

- **S3 mount** (read-only) — project files mounted via s3fs at `/mnt/project_files/`
- **Symlinks** — binary files (PDFs, images) link to the S3 mount. Text files are copied locally for editing.
- **Auto-sync** — after each command, the workspace is scanned for changes. New files are created as project assets, modified files are updated in S3, deleted files are removed. This happens automatically — no manual sync step.
- **Manifest** — `.workspace.json` lists all available files with URIs, regenerated after sync.

The text/binary classification uses a whitelist of text extensions (~60 entries). Files above 50MB are always symlinked regardless of type.

---

## Credential Injection

User credentials (GitHub tokens, API keys, etc. from platform integrations) are injected into the sandbox environment on creation. They are set as environment variables, **not** included in agent prompts — this prevents credentials from leaking into LLM context.

---

## Terminal Access

Users can attach to the sandbox terminal via ttyd (WebSocket-based terminal) connected to the tmux session. This lets users see what the agent is doing in real-time and interact with the same shell.

---

## Safety

Sandbox safety is minimal compared to browser and desktop — the environment is already isolated. The only check is **resource access control** for web URLs (e.g., if the agent runs `curl` or `pip install`, the URL is checked against the resource access service). File system access within the sandbox doesn't need permission checks since it's isolated from the user's machine.

soft_links: [/kael/platform]
