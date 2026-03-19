---
title: Kael API — Model Tools CLI
owners: [liuchao-001]
---

# Kael API — Model Tools CLI

Kael's model tools (TTS, OCR, image generation, STT) were originally pydantic-ai native tools — tightly coupled to the backend process and callable only by Kael's own agent. This section records the decision to expose them as an HTTP endpoint backed by a CLI package (`kael-api`), making them callable by any agent that can execute shell commands.

## Core Decision

Model tools are published as a CLI (`kael-api model tts/ocr/generate-image/stt`) rather than remaining native-only. The CLI communicates with an HTTP endpoint on kael-backend (`POST /mcp/tools/call`), not by embedding logic in the CLI itself.

This means:
- Any agent running inside an E2B sandbox — or any developer on their local machine — can call these tools without being Kael's own agent.
- kael-backend stays the authority over credentials, billing, and external service calls.

## Current Product Truth

**Endpoint**: `POST /mcp/tools/call` on kael-backend. Authentication is a short-lived user-scoped JWT (8 hours, scope `kael-api`), injected into the E2B sandbox by `inject_credentials` at sandbox creation/resume time. External users: environment variable `KAEL_API_KEY` or `kael login` (not yet implemented — see Issue #37).

**CLI package**: `kael-api`, installed to `/usr/local/bin/` via `sudo pip3 install` in the E2B sandbox template. Installed globally rather than user-local so it is available in non-interactive shell sessions. The package reads `KAEL_API_KEY` and `KAEL_SERVER_URL` from the environment; both are injected by `inject_credentials` alongside OAuth credentials.

**Transport**: Simple HTTP JSON (`{"tool": "...", "params": {...}}`), not JSON-RPC 2.0. The endpoint is intentionally minimal — no session state, no streaming, no protocol negotiation.

**Temp file storage**: Generated files (TTS audio, generated images) are stored in S3 under `mcp-outputs/<uuid>.<ext>` with presigned URLs valid for 24 hours. S3 lifecycle policy deletes them automatically. No database record is created. Agents that want to persist a result call `file_download` to copy it into a project asset.

**`file_save` was rejected**: An early design added a `file_save` native tool as a companion to temp URL outputs. This was dropped because `file_download` already accepts any public URL including presigned S3 URLs. Adding a second tool for the same action would have been redundant.

**`inject_credentials` ordering**: The `_inject_kael_api_credentials` step runs unconditionally, before the OAuth gate. The previous design ran all credential injection under the OAuth gate, which meant kael-api credentials were silently skipped when `oauth_encryption_key` was not set. The fix decouples them.

## Extension Boundary

- External user authentication (`kael login`, API key management page) is tracked separately in Issue #37. The CLI slot for it already exists (`~/.kael/config.json`), but the OAuth flow and web UI are not implemented.
- Additional tools (e.g., Slides generation) can be added to the MCP endpoint and CLI without changing the transport or auth model.
- Publishing `kael-api` to PyPI is deferred; it is currently distributed as a wheel built from the `cli/` directory of kael-backend.

## Cross-Domain Links

- Credential injection and sandbox startup: [../../agent/runtime.md](../../agent/runtime.md)
- Project asset system (where `file_download` stores results): [../project-asset-system.md](../project-asset-system.md)
- External user authentication (Issue #37): [../auth/backend.md](../auth/backend.md)
