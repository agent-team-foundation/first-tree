---
title: Browser Extension Authentication
owners: []
---

# Browser Extension Authentication

## Auth Flow

1. User clicks Login in extension popup
2. Extension calls `chrome.identity.launchWebAuthFlow()` → opens frontend at `{FRONTEND_URL}/api/auth/browser-extension-callback?device_id={uuid}&extension_id={id}`
3. Frontend checks BetterAuth session (redirects to sign-in if needed)
4. Frontend calls backend `POST /api/v1/auth/browser-extension/token` with `X-Internal-API-Key` + `{user_id, device_id}`
5. Backend creates JWT, stores token record in database
6. Frontend redirects to `https://{extensionId}.chromiumapp.org/callback#{token=...&expires_at=...}`
7. Extension parses token from URL fragment, stores in `chrome.storage.local`
8. Extension connects WebSocket: `wss://api.kael.im/api/v1/ws/browser?token={jwt}`
9. API calls use `Authorization: Bearer {jwt}`

## Security Properties

- **Fragment-based token delivery** — token in URL fragment (`#`), never sent to servers, not in logs or Referer headers
- **Extension ID validation** — server-side env var (`NEXT_PUBLIC_CHROME_EXTENSION_ID`) validated with regex `/^[a-p]{32}$/`, prevents open redirect
- **Chrome-enforced redirect** — `chromiumapp.org` is Chrome-internal, only the matching extension receives the redirect
- **No explicit CSRF token** — relies on Chrome's `launchWebAuthFlow` platform guarantee that only the matching extension receives the callback (different approach from desktop's state nonce, but equivalent protection)

## Token Lifecycle

- Expiry: 7 days
- No refresh mechanism — user must re-authenticate on expiry
- Token checked for expiry with 5-minute buffer before each use
- Revocable via backend API (per-user or per-device)

## Device ID

Generated once via `crypto.randomUUID()` (UUID v4), persisted in `chrome.storage.local`, reused across auth sessions.
