---
title: Desktop App Authentication
owners: []
---

# Desktop App Authentication

## Auth Flow

1. Desktop app binds a one-shot HTTP server on `127.0.0.1:0` (OS picks a free port)
2. Generates a `state` nonce (UUID v4) for CSRF protection
3. Opens browser to `{FRONTEND_URL}/api/auth/desktop-app-callback?device_id={id}&callback_port={port}&state={nonce}`
4. Frontend checks BetterAuth session (redirects to sign-in if needed)
5. Frontend calls backend `POST /api/v1/auth/desktop-app/token` with `X-Internal-API-Key` + `{user_id, device_id}`
6. Backend creates JWT, stores token record in database
7. Frontend redirects browser to `http://127.0.0.1:{port}/callback?token={jwt}&user_id=...&expires_at=...&state={nonce}`
8. Desktop app validates `state` matches the nonce it generated — rejects on mismatch ("possible CSRF attack")
9. Desktop app stores JWT in Tauri plugin-store (`auth.json`)
10. Connects WebSocket: `wss://{backend}/api/v1/ws/desktop?token={jwt}`

## Security Properties

- **CSRF protection via state nonce** — prevents login CSRF where an attacker tricks the user into authenticating as the attacker's account (user unknowingly works inside attacker-controlled account, data goes to attacker)
- **Loopback-only binding** — callback server binds to `127.0.0.1`, not `0.0.0.0`, only local browser can reach it
- **One-shot server** — accepts exactly one request then shuts down, prevents replay
- **Auth timeout** — 2-minute timeout for user to complete login, server cleaned up on timeout
- **Callback port validation** — frontend validates port range (1024-65535)

## Token Lifecycle

- Expiry: 30 days
- No refresh mechanism — user must re-authenticate on expiry
- Revocable via backend API (per-user or per-device)
- Dev mode: settings UI allows pasting JWT directly (bypasses browser auth flow)

## Device ID

Generated once via `uuid::Uuid::new_v4()`, persisted in Tauri plugin-store (`auth.json`), reused across auth sessions.
