---
title: Authentication
owners: []
---

# Authentication

Kael uses a layered authentication architecture. Each layer serves a distinct purpose and relies on different secrets.

## Layer 1: User Identity (BetterAuth)

BetterAuth runs on the frontend (kael-frontend) as the single source of user identity. It resolves a session cookie into a `user_id`. This layer is purely identification — it has no role in securing communication between frontend and backend.

- Session storage: PostgreSQL-backed, secure HttpOnly cookies
- Auth methods: email/password (with email verification), Google OAuth
- Anonymous users: supported via BetterAuth anonymous plugin, resources transfer on sign-up
- Secret: `BETTER_AUTH_SECRET`

## Layer 2: Frontend-to-Backend (INTERNAL_API_KEY)

The backend URL is not exposed to clients. The Vercel-hosted frontend acts as a reverse proxy, injecting a static shared secret (`X-Internal-API-Key` header) on every server-side API route call. The backend validates this header on all `/api/v1` routes.

- `user_id` is passed as a request parameter, trusted because the request carries the correct API key
- Skipped on `127.0.0.1` for local development
- WebSocket and MCP endpoints have per-route auth instead

## Layer 3: Device Connections (JWT_SECRET_KEY)

Browser extension and desktop app need persistent WebSocket connections directly to the backend (bypassing the frontend proxy). JWT tokens signed with `JWT_SECRET_KEY` (HS256) authenticate these connections.

- Tokens are issued by the backend, requested through the frontend (which verifies user identity first)
- Token payload: `user_id`, `device_id`, `token_version`, `type`, `iat`, `exp`
- Token records stored in database for version tracking and revocation
- WebSocket auth: JWT passed as query parameter (`?token={jwt}`)

| Client | Token Expiry | Storage |
|---|---|---|
| Browser extension | 7 days | `chrome.storage.local` |
| Desktop app | 30 days | Tauri `auth.json` (plugin-store) |

## Additional Secrets

- `KAEL_CLI_JWT_SECRET` — separate JWT secret for kael-cli/kael-api MCP endpoint authentication
- `OAUTH_ENCRYPTION_KEY` — Fernet key encrypting third-party OAuth tokens in the database
