---
title: Backend Authentication
owners: []
---

# Backend Authentication

## INTERNAL_API_KEY

All `/api/v1` routes are protected by the `verify_internal_api_key()` dependency (`kael-backend/src/api/deps.py`), which checks the `X-Internal-API-Key` header.

Exceptions with per-route auth:
- `browser_extension_auth` — per-endpoint API key check
- `browser_ws`, `desktop_ws` — JWT query parameter
- `terminal_ws` — API key as query parameter
- `mcp` — `kael_cli_jwt_secret` Bearer token
- `channels` — webhook has no auth, others require API key

## JWT Token Issuance

The backend signs JWTs for browser extension and desktop app using `JWT_SECRET_KEY` (HS256).

Token creation (`kael-backend/src/browser_control/auth_service.py`, `desktop_control/auth_service.py`):
1. Frontend calls `POST /api/v1/auth/{browser-extension|desktop-app}/token` with `X-Internal-API-Key`
2. Backend checks for existing token record to determine version
3. Upserts token record in database (user_id + device_id, unique constraint)
4. Signs JWT with payload: `user_id`, `device_id`, `token_version`, `type`, `iat`, `exp`

Token verification:
1. Decode JWT, validate signature and expiry
2. Check `type` claim matches expected token type
3. Check database: token not revoked, version matches current

## WebSocket Authentication

Browser extension and desktop WebSocket endpoints (`/ws/browser`, `/ws/desktop`) verify JWT from query parameter before accepting the connection. Invalid/expired tokens receive close code `4001`.

## Token Revocation

Tokens can be revoked per-user or per-device via `POST /api/v1/auth/{type}/revoke`. Revocation sets `revoked_at` timestamp in the database. Token versioning also invalidates old tokens — re-authentication increments version, previous version is rejected on verify.
